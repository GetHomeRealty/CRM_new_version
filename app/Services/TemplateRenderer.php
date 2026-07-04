<?php

namespace App\Services;

/**
 * Plain, safe {{ variable }} substitution — no Blade, no eval. Unknown tokens
 * render as an empty string.
 */
class TemplateRenderer
{
    public static function render(string $template, array $vars): string
    {
        return preg_replace_callback('/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/', function ($m) use ($vars) {
            $key = $m[1];

            return array_key_exists($key, $vars) && $vars[$key] !== null ? (string) $vars[$key] : '';
        }, $template) ?? $template;
    }
}
