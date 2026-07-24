/**
 * In-browser voice calling (Twilio Voice SDK) configuration.
 *
 * Distinct from SMS: minting a client Access Token needs an API Key/Secret pair (not the account
 * auth token) and a TwiML Application whose Voice URL Twilio fetches when the browser places a
 * call. The account SID + From number are shared with the SMS/voice config in `sms.constants`.
 */
const env = (k: string): string => String(process.env[k] ?? '').trim();

export const voiceApiKey = (): string => env('TWILIO_API_KEY');
export const voiceApiSecret = (): string => env('TWILIO_API_SECRET');
export const twimlAppSid = (): string => env('TWILIO_TWIML_APP_SID');
