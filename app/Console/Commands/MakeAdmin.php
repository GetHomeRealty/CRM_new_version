<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

class MakeAdmin extends Command
{
    protected $signature = 'user:admin {email}';

    protected $description = 'Promote a user to the administrator role';

    public function handle(): int
    {
        $user = User::where('email', $this->argument('email'))->first();

        if (! $user) {
            $this->error("No user found with email {$this->argument('email')}.");

            return self::FAILURE;
        }

        $user->update(['role' => 'admin']);
        $this->info("{$user->name} <{$user->email}> is now an administrator.");

        return self::SUCCESS;
    }
}
