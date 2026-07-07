<?php

namespace App\Services;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Http;

/**
 * Extracts identity fields from a client's photo-ID image/PDF for FINTRAC Form 630.
 * Provider is configurable (config/services.php → id_extraction); currently Anthropic
 * Claude vision. Never throws for provider/parse issues — returns null fields so the
 * upload flow degrades gracefully. Does not log raw field values or image contents.
 */
class IdExtractionService
{
    private const BLANK = [
        'full_legal_name' => null, 'address' => null, 'dob' => null, 'occupation' => null,
        'id_type' => null, 'id_number' => null, 'issuing_jurisdiction' => null,
        'country' => null, 'expiry_date' => null,
    ];

    /**
     * @return array{ok: bool, configured: bool, fields: array<string, string|null>}
     */
    public function extractIdFields(string $contents, string $mime): array
    {
        $provider = config('services.id_extraction.provider', 'anthropic');
        $key = config('services.id_extraction.anthropic.key');

        if ($provider !== 'anthropic' || empty($key)) {
            return ['ok' => false, 'configured' => false, 'fields' => self::BLANK];
        }

        try {
            $raw = $this->callAnthropic($contents, $mime, $key);
        } catch (\Throwable $e) {
            report($e); // reports the exception; never includes field values

            return ['ok' => false, 'configured' => true, 'fields' => self::BLANK];
        }

        $data = $this->decodeJson($raw);
        if (! is_array($data)) {
            return ['ok' => false, 'configured' => true, 'fields' => self::BLANK];
        }

        return ['ok' => true, 'configured' => true, 'fields' => $this->normalize($data)];
    }

    private function callAnthropic(string $contents, string $mime, string $key): string
    {
        $model = config('services.id_extraction.anthropic.model', 'claude-sonnet-5');
        $isPdf = $mime === 'application/pdf';

        $prompt = 'You are extracting fields from a single government-issued identity document '
            .'(driver licence, passport, or provincial ID). Read only what is printed; never guess or invent. '
            .'Return ONLY a compact JSON object with exactly these keys and nothing else: '
            .'{"full_name":string|null,"address":string|null,"date_of_birth":string|null,'
            .'"document_type":"driver_licence"|"passport"|"other"|null,"document_number":string|null,'
            .'"issuing_jurisdiction":string|null,"country":string|null,"expiry_date":string|null,"confidence":number}. '
            .'Rules: dates as ISO YYYY-MM-DD; full_name in natural reading order (given names then surname); '
            .'issuing_jurisdiction is the province/state/authority that issued the document; country is the issuing country; '
            .'use null for any field that is absent or not legible; confidence is 0..1 for the overall read.';

        $media = [
            'type' => $isPdf ? 'document' : 'image',
            'source' => ['type' => 'base64', 'media_type' => $isPdf ? 'application/pdf' : $mime, 'data' => base64_encode($contents)],
        ];

        $res = Http::withHeaders([
            'x-api-key' => $key,
            'anthropic-version' => '2023-06-01',
            'content-type' => 'application/json',
        ])->timeout(45)->post('https://api.anthropic.com/v1/messages', [
            'model' => $model,
            'max_tokens' => 1024,
            'messages' => [[
                'role' => 'user',
                'content' => [$media, ['type' => 'text', 'text' => $prompt]],
            ]],
        ]);

        if (! $res->successful()) {
            throw new \RuntimeException('ID extraction provider returned HTTP '.$res->status());
        }

        return (string) $res->json('content.0.text', '');
    }

    private function decodeJson(string $raw): mixed
    {
        $raw = trim($raw);
        if (str_starts_with($raw, '```')) {
            $raw = (string) preg_replace('/^```[a-z]*\s*|\s*```$/i', '', $raw);
        }
        if (preg_match('/\{.*\}/s', $raw, $m)) {
            $raw = $m[0];
        }

        return json_decode($raw, true);
    }

    /** Map provider JSON onto our fields, normalising dates and the document type. */
    private function normalize(array $d): array
    {
        $str = static fn ($v) => (is_string($v) && trim($v) !== '') ? trim($v) : null;

        $type = match (strtolower((string) ($d['document_type'] ?? ''))) {
            'driver_licence', 'driver_license', 'drivers_licence', 'drivers_license', 'driving_licence', 'driving_license', 'dl' => "Driver's Licence",
            'passport' => 'Passport',
            'other' => 'Other',
            default => null,
        };

        return [
            'full_legal_name' => $str($d['full_name'] ?? null),
            'address' => $str($d['address'] ?? null),
            'dob' => $this->isoDate($d['date_of_birth'] ?? null),
            'occupation' => null, // not present on IDs; completed manually
            'id_type' => $type,
            'id_number' => $str($d['document_number'] ?? null),
            'issuing_jurisdiction' => $str($d['issuing_jurisdiction'] ?? null),
            'country' => $str($d['country'] ?? null),
            'expiry_date' => $this->isoDate($d['expiry_date'] ?? null),
        ];
    }

    /** Normalise a date string to YYYY-MM-DD (the format the Form 630 date inputs use). */
    private function isoDate($v): ?string
    {
        if (! is_string($v) || trim($v) === '') {
            return null;
        }
        try {
            return Carbon::parse(trim($v))->format('Y-m-d');
        } catch (\Throwable) {
            return null;
        }
    }
}
