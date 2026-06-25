<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use App\Services\PermissionService;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'username',
        'email',
        'password',
        'role',
        'status',
        'profile',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'profile' => 'array',
        ];
    }

    public function isActive(): bool
    {
        return ($this->status ?? 'Active') !== 'Inactive';
    }

    public function permissions(): HasMany
    {
        return $this->hasMany(UserPermission::class);
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    /**
     * Role tiers (relabel-in-place mapping — stored strings are unchanged):
     *   stored 'admin'   => Super Admin (highest)
     *   stored 'manager' => Admin
     *   stored 'agent'   => Agent
     */
    public function isSuperAdmin(): bool
    {
        return $this->role === 'admin';
    }

    /** Admin tier or higher (Admin + Super Admin) — manage across agents. */
    public function isAdminOrAbove(): bool
    {
        return in_array($this->role, ['admin', 'manager'], true);
    }

    public function roleLabel(): string
    {
        return app(PermissionService::class)->label($this->role ?? 'agent');
    }

    /** Effective screen permission map (screen => level). */
    public function effectivePermissions(): array
    {
        return app(PermissionService::class)->effectiveFor($this);
    }

    public function canScreen(string $screen, string $level = 'view'): bool
    {
        return app(PermissionService::class)->can($this, $screen, $level);
    }
}
