<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\AuditService;
use App\Services\PermissionService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;

class UserController extends Controller
{
    public function __construct(private PermissionService $permissions, private AuditService $audit)
    {
    }

    public function index()
    {
        return response()->json(
            User::with('permissions')->orderBy('name')->get()->map(fn (User $u) => $this->payload($u))
        );
    }

    public function store(Request $request)
    {
        $data = $request->validate($this->rules());

        $user = User::create([
            'name' => $data['name'],
            'username' => $data['username'] ?? null,
            'email' => $data['email'],
            'password' => Hash::make($data['password']),
            'role' => $data['role'],
            'status' => $data['status'] ?? 'Active',
            'profile' => $data['profile'] ?? null,
        ]);

        $this->syncPermissions($user, $data['permissions'] ?? []);

        $this->audit->logModule('Users', [
            'section' => 'User Management', 'field' => $user->name, 'action' => 'User created',
            'details' => "{$user->email} · {$this->permissions->label($user->role)}",
        ]);

        return response()->json($this->payload($user->fresh('permissions')), 201);
    }

    public function update(Request $request, User $user)
    {
        $data = $request->validate($this->rules($user));

        $user->fill([
            'name' => $data['name'],
            'username' => $data['username'] ?? $user->username,
            'email' => $data['email'],
            'role' => $data['role'],
            'status' => $data['status'] ?? $user->status ?? 'Active',
            'profile' => array_key_exists('profile', $data) ? $data['profile'] : $user->profile,
        ]);
        if (! empty($data['password'])) {
            $user->password = Hash::make($data['password']);
        }
        $user->save();

        $this->syncPermissions($user, $data['permissions'] ?? []);

        $this->audit->logModule('Users', [
            'section' => 'User Management', 'field' => $user->name, 'action' => 'User updated',
            'details' => "{$user->email} · {$this->permissions->label($user->role)} · {$user->status}",
        ]);

        return response()->json($this->payload($user->fresh('permissions')));
    }

    public function destroy(Request $request, User $user)
    {
        abort_if($user->id === $request->user()->id, 422, 'You cannot delete your own account.');
        abort_if($user->isAdmin() && User::where('role', 'admin')->count() <= 1, 422, 'Cannot delete the last administrator.');

        $name = $user->name;
        $email = $user->email;
        $user->delete();

        $this->audit->logModule('Users', [
            'section' => 'User Management', 'field' => $name, 'action' => 'User deleted', 'details' => $email,
        ]);

        return response()->json(['message' => 'User deleted']);
    }

    /** Screens / roles / levels / role-defaults for the permission editor. */
    public function catalog()
    {
        return response()->json($this->permissions->catalog());
    }

    private function rules(?User $user = null): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'username' => [$user ? 'nullable' : 'required', 'string', 'max:255', Rule::unique('users', 'username')->ignore($user?->id)],
            'email' => ['required', 'email', 'max:255', Rule::unique('users', 'email')->ignore($user?->id)],
            'password' => $user ? ['nullable', 'confirmed', Password::defaults()] : ['required', 'confirmed', Password::defaults()],
            'role' => ['required', Rule::in(PermissionService::ROLES)],
            'status' => ['nullable', Rule::in(['Active', 'Inactive'])],
            'profile' => ['nullable', 'array'],
            'permissions' => ['nullable', 'array'],
            'permissions.*' => [Rule::in(PermissionService::LEVELS)],
        ];
    }

    /** Persist only the overrides that differ from the role default. */
    private function syncPermissions(User $user, array $map): void
    {
        $defaults = $this->permissions->roleDefaults($user->role);
        $user->permissions()->delete();

        foreach ($map as $screen => $level) {
            if (! array_key_exists($screen, PermissionService::SCREENS)) {
                continue;
            }
            if (! in_array($level, PermissionService::LEVELS, true)) {
                continue;
            }
            if (($defaults[$screen] ?? 'none') !== $level) {
                $user->permissions()->create(['screen' => $screen, 'level' => $level]);
            }
        }
    }

    /**
     * The agent's paid (Closed) deals as PRIMARY agent, oldest first, limited to the
     * "Existing Split Deals Count" — i.e. the deals done under the previous split.
     * Each row carries the split that was used on that deal.
     */
    public function dealHistory(User $user)
    {
        $name = $user->name;
        $threshold = (int) (($user->profile['completed_deals'] ?? 0));

        $query = \App\Models\Transaction::where('agent', $name)
            ->whereHas('statuses', fn ($s) => $s->where('status', 'Closed'))
            ->with(['teamMembers' => fn ($tm) => $tm->where('name', $name)])
            ->orderBy('closing_date')
            ->orderBy('id');

        $deals = ($threshold > 0 ? $query->limit($threshold)->get() : $query->get());

        $profile = $user->profile ?? [];
        return response()->json($deals->map(function ($t) use ($name, $profile) {
            $m = $t->teamMembers->firstWhere('name', $name);
            $agentPct = $m ? (float) $m->agent_pct : ($profile['agent_comm_pct'] ?? null);
            $brokPct = $m ? (float) $m->brok_pct : ($profile['brok_comm_pct'] ?? null);

            return [
                'brokerage' => 'Get Home Realty',
                'property' => $t->property,
                'trade_no' => $t->trade_no,
                'agent_pct' => $agentPct !== null ? (float) $agentPct : null,
                'brok_pct' => $brokPct !== null ? (float) $brokPct : null,
                'closing_date' => optional($t->closing_date)->toDateString(),
            ];
        })->values());
    }

    private function payload(User $u): array
    {
        return [
            'id' => $u->id,
            'name' => $u->name,
            'username' => $u->username,
            'email' => $u->email,
            'role' => $u->role,
            'status' => $u->status ?? 'Active',
            'profile' => $u->profile ?? [],
            'is_admin' => $u->isAdmin(),
            'permissions' => $this->permissions->effectiveFor($u),
            'overrides' => $u->permissions->mapWithKeys(fn ($p) => [$p->screen => $p->level]),
        ];
    }
}
