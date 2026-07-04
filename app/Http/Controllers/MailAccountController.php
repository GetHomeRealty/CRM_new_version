<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreMailAccountRequest;
use App\Http\Requests\UpdateMailAccountRequest;
use App\Http\Resources\MailAccountResource;
use App\Models\MailAccount;
use App\Services\TemplateMailService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class MailAccountController extends Controller
{
    public function index()
    {
        return MailAccountResource::collection(
            MailAccount::orderByDesc('is_default')->orderBy('name')->get()
        );
    }

    public function store(StoreMailAccountRequest $request)
    {
        $data = $request->validated();
        // A blank password on create simply stores none.
        if (($data['password'] ?? '') === '') {
            unset($data['password']);
        }

        $account = DB::transaction(function () use ($data) {
            $account = MailAccount::create($data);
            if ($account->is_default) {
                $this->makeSoleDefault($account);
            }

            return $account;
        });

        return new MailAccountResource($account);
    }

    public function update(UpdateMailAccountRequest $request, MailAccount $mailAccount)
    {
        $data = $request->validated();
        // Preserve the existing password when the field is blank/omitted.
        if (! array_key_exists('password', $data) || $data['password'] === null || $data['password'] === '') {
            unset($data['password']);
        }

        DB::transaction(function () use ($mailAccount, $data) {
            $mailAccount->update($data);
            if ($mailAccount->is_default) {
                $this->makeSoleDefault($mailAccount);
            }
        });

        return new MailAccountResource($mailAccount->fresh());
    }

    public function destroy(MailAccount $mailAccount)
    {
        $mailAccount->delete();

        return response()->json(['message' => 'Mail account deleted']);
    }

    /** Make this account the one and only default (and keep it active). */
    public function setDefault(MailAccount $mailAccount)
    {
        DB::transaction(function () use ($mailAccount) {
            $mailAccount->update(['is_default' => true, 'is_active' => true]);
            $this->makeSoleDefault($mailAccount);
        });

        return new MailAccountResource($mailAccount->fresh());
    }

    /** Send a test email through this account to verify the SMTP settings. */
    public function test(Request $request, MailAccount $mailAccount, TemplateMailService $mailer)
    {
        $data = $request->validate(['to' => ['required', 'email']]);

        try {
            $mailer->test($mailAccount, $data['to']);
        } catch (\Throwable $e) {
            return response()->json(['ok' => false, 'message' => 'Send failed: '.$e->getMessage()], 422);
        }

        return response()->json(['ok' => true, 'message' => "Test email sent to {$data['to']}."]);
    }

    /** Ensure exactly one row carries is_default = true. */
    private function makeSoleDefault(MailAccount $account): void
    {
        MailAccount::where('id', '!=', $account->id)->where('is_default', true)->update(['is_default' => false]);
    }
}
