<?php

namespace App\Services;

use App\Models\User;

/**
 * Screen-level access control. Effective access = role defaults overlaid with
 * any per-user overrides. Admin always has full access to everything.
 *
 * Levels are ranked: none(0) < view(1) < edit(2).
 */
class PermissionService
{
    public const LEVELS = ['none', 'view', 'edit'];

    /** Screen catalog (key => label) — mirrors the sidebar nav. */
    public const SCREENS = [
        'dashboard' => 'Dashboard',
        'analytics' => 'Analytics',
        'calendar' => 'Calendar',
        'reviews' => 'Client Reviews',
        'favorites' => 'Favorites',
        'inbox' => 'Inbox',
        'inventory' => 'Inventory',
        'invoice' => 'Invoice',
        'lead' => 'Lead',
        'mls' => 'MLS',
        'reports' => 'Reports',
        'triggers' => 'Triggers',
        'transactions' => 'Transactions',
        'users' => 'Users',
        'settings' => 'Settings',
    ];

    public const ROLES = ['admin', 'manager', 'agent'];

    /** Display labels (relabel-in-place): stored role => UI tier name. */
    public const ROLE_LABELS = ['admin' => 'Super Admin', 'manager' => 'Admin', 'agent' => 'Agent'];

    public function label(string $role): string
    {
        return self::ROLE_LABELS[$role] ?? ucfirst($role);
    }

    private function rank(string $level): int
    {
        return array_search($level, self::LEVELS, true) ?: 0;
    }

    /** Default permission map for a role: screen => level. */
    public function roleDefaults(string $role): array
    {
        $all = fn (string $level) => array_fill_keys(array_keys(self::SCREENS), $level);

        return match ($role) {
            'admin' => $all('edit'),
            'manager' => array_merge($all('edit'), ['users' => 'none', 'settings' => 'view']),
            default => array_merge($all('none'), [ // agent
                'dashboard' => 'view',
                'transactions' => 'edit',
                'analytics' => 'view',
                'calendar' => 'view',
                'inventory' => 'view',
                'invoice' => 'view',
                'mls' => 'view',
                'reports' => 'view',
            ]),
        };
    }

    /** Effective permissions for a user: role defaults + overrides. Admin = all edit. */
    public function effectiveFor(User $user): array
    {
        if ($user->role === 'admin') {
            return array_fill_keys(array_keys(self::SCREENS), 'edit');
        }

        $perms = $this->roleDefaults($user->role ?? 'agent');

        $overrides = $user->relationLoaded('permissions') ? $user->permissions : $user->permissions()->get();
        foreach ($overrides as $o) {
            if (array_key_exists($o->screen, self::SCREENS) && in_array($o->level, self::LEVELS, true)) {
                $perms[$o->screen] = $o->level;
            }
        }

        return $perms;
    }

    /** Does the user have at least $level on $screen? */
    public function can(User $user, string $screen, string $level = 'view'): bool
    {
        $perms = $this->effectiveFor($user);
        $have = $perms[$screen] ?? 'none';

        return $this->rank($have) >= $this->rank($level);
    }

    /** Catalog for the permission editor UI. */
    public function catalog(): array
    {
        return [
            'screens' => collect(self::SCREENS)->map(fn ($label, $key) => ['key' => $key, 'label' => $label])->values(),
            'roles' => self::ROLES,
            'role_labels' => self::ROLE_LABELS,
            'levels' => self::LEVELS,
            'role_defaults' => collect(self::ROLES)->mapWithKeys(fn ($r) => [$r => $this->roleDefaults($r)]),
        ];
    }
}
