<?php

use App\Http\Controllers\AgentController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\CompanySettingController;
use App\Http\Controllers\CustomerController;
use App\Http\Controllers\DocumentController;
use App\Http\Controllers\InvoiceController;
use App\Http\Controllers\TransactionController;
use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

// Public auth endpoints (session/cookie based via Sanctum).
Route::post('/register', [AuthController::class, 'register']);   // bootstrap first admin only
Route::post('/login', [AuthController::class, 'login']);
Route::get('/registration-open', [AuthController::class, 'registrationOpen']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', [AuthController::class, 'me']);
    Route::post('/logout', [AuthController::class, 'logout']);

    // Reference data (any authenticated staff).
    Route::get('/agents', [AgentController::class, 'index']);
    Route::get('/transaction-types', fn () => response()->json([
        'types' => \App\Models\Transaction::TYPES,
        'listing_types' => \App\Models\Transaction::LISTING_TYPES,
    ]));

    // Transactions — reads available to any authenticated user (Dashboard,
    // Analytics, etc. all consume this); writes require transactions:edit.
    Route::get('/transactions', [TransactionController::class, 'index']);
    Route::get('/transactions/{transaction}', [TransactionController::class, 'show']);
    Route::get('/transactions/{transaction}/documents', [DocumentController::class, 'index']);
    Route::get('/documents/{document}/file', [DocumentController::class, 'downloadFile']);

    Route::middleware('screen:transactions,edit')->group(function () {
        Route::post('/transactions', [TransactionController::class, 'store']);
        Route::put('/transactions/{transaction}', [TransactionController::class, 'update']);
        Route::delete('/transactions/{transaction}', [TransactionController::class, 'destroy']);

        Route::put('/transactions/{transaction}/documents', [DocumentController::class, 'bulkUpdate']);
        Route::post('/transactions/{transaction}/documents/{document}/file', [DocumentController::class, 'uploadFile']);
        Route::delete('/documents/{document}', [DocumentController::class, 'destroy']);
    });

    // Invoice module
    Route::get('/company-settings', [CompanySettingController::class, 'show']); // any staff (printed on invoices)
    Route::middleware('screen:invoice,view')->group(function () {
        Route::get('/invoices', [InvoiceController::class, 'index']);
        Route::get('/invoices/{invoice}', [InvoiceController::class, 'show']);
        Route::get('/customers', [CustomerController::class, 'index']);
    });
    Route::middleware('screen:invoice,edit')->group(function () {
        Route::post('/invoices', [InvoiceController::class, 'store']);
        Route::post('/transactions/{transaction}/invoices', [InvoiceController::class, 'generateForTransaction']);
        Route::put('/invoices/{invoice}', [InvoiceController::class, 'update']);
        Route::delete('/invoices/{invoice}', [InvoiceController::class, 'destroy']);
        Route::post('/invoices/{invoice}/payments', [InvoiceController::class, 'recordPayment']);
        Route::delete('/invoices/{invoice}/payments/{payment}', [InvoiceController::class, 'deletePayment']);
        Route::post('/customers', [CustomerController::class, 'store']);
        Route::put('/customers/{customer}', [CustomerController::class, 'update']);
        Route::delete('/customers/{customer}', [CustomerController::class, 'destroy']);
    });

    // User management — administrators only.
    Route::middleware('admin')->group(function () {
        Route::put('/company-settings', [CompanySettingController::class, 'update']);
        Route::get('/users/catalog', [UserController::class, 'catalog']);
        Route::apiResource('users', UserController::class)->except(['show']);
    });
});
