<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\PermissionService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function __construct(private PermissionService $permissions)
    {
    }

    /**
     * Bootstrap registration — only allowed while there are zero users (creates
     * the first Admin). After that, accounts are created by admins via /api/users.
     */
    public function register(Request $request): JsonResponse
    {
        abort_if(User::query()->exists(), 403, 'Registration is closed. Ask an administrator to create your account.');

        $validated = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'confirmed', Password::defaults()],
        ]);

        $user = User::create([
            'name' => $validated['name'],
            'email' => $validated['email'],
            'password' => Hash::make($validated['password']),
            'role' => 'admin', // first user is the administrator
        ]);

        Auth::login($user);
        $request->session()->regenerate();

        return response()->json(['user' => $this->payload($user)], 201);
    }

    public function login(Request $request): JsonResponse
    {
        $credentials = $request->validate([
            'username' => ['required', 'string'],
            'password' => ['required', 'string'],
        ]);

        // Log in by username, falling back to email (usernames may themselves be
        // email-formatted, so we can't guess the column — try both).
        $login = $credentials['username'];
        $password = $credentials['password'];
        $remember = $request->boolean('remember');

        $ok = Auth::attempt(['username' => $login, 'password' => $password], $remember)
            || Auth::attempt(['email' => $login, 'password' => $password], $remember);

        if (! $ok) {
            throw ValidationException::withMessages([
                'username' => ['The provided credentials are incorrect.'],
            ]);
        }

        // Inactive users cannot log in.
        if (! $request->user()->isActive()) {
            Auth::guard('web')->logout();
            throw ValidationException::withMessages([
                'username' => ['This account is inactive. Please contact an administrator.'],
            ]);
        }

        $request->session()->regenerate();

        return response()->json(['user' => $this->payload($request->user())]);
    }

    /** Any signed-in user changes their own password (current password required). */
    public function changePassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'current_password' => ['required', 'string'],
            'password' => ['required', 'confirmed', Password::defaults()],
        ]);

        $user = $request->user();
        if (! Hash::check($data['current_password'], $user->password)) {
            throw ValidationException::withMessages([
                'current_password' => ['Your current password is incorrect.'],
            ]);
        }

        $user->update(['password' => $data['password']]); // 'hashed' cast hashes it

        return response()->json(['message' => 'Password updated']);
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();
        

        return response()->json(['message' => 'Logged out']);
    }

    /** Current authenticated user with role + effective permissions. */
    public function me(Request $request): JsonResponse
    {
        return response()->json($this->payload($request->user()));
    }

    /** Whether bootstrap registration is still open (no users yet). */
    public function registrationOpen(): JsonResponse
    {
        return response()->json(['open' => ! User::query()->exists()]);
    }

    private function payload(User $user): array
    {
        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
            'role_label' => $user->roleLabel(),
            'is_admin' => $user->isAdmin(),
            'is_super_admin' => $user->isSuperAdmin(),
            'is_admin_or_above' => $user->isAdminOrAbove(),
            'permissions' => $this->permissions->effectiveFor($user),
        ];
    }
}
