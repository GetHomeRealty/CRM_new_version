<?php

use App\Http\Controllers\AgentController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\TransactionController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

// Public authentication endpoints (session/cookie based via Sanctum).
Route::post('/register', [AuthController::class, 'register']);
Route::post('/login', [AuthController::class, 'login']);

// Authenticated endpoints — require a valid Sanctum session/token.
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', fn (Request $request) => $request->user());
    Route::post('/logout', [AuthController::class, 'logout']);

    // Transaction Desk
    Route::apiResource('transactions', TransactionController::class);
    Route::get('/agents', [AgentController::class, 'index']);

    // Reference data for the Add modal / detail forms.
    Route::get('/transaction-types', fn () => response()->json([
        'types' => \App\Models\Transaction::TYPES,
        'listing_types' => \App\Models\Transaction::LISTING_TYPES,
    ]));
});
