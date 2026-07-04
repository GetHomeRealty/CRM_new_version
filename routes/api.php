<?php

use App\Http\Controllers\AgentController;
use App\Http\Controllers\AuditLogController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\CompanySettingController;
use App\Http\Controllers\CustomerController;
use App\Http\Controllers\DepositReceiptController;
use App\Http\Controllers\DocumentController;
use App\Http\Controllers\EmailTemplateController;
use App\Http\Controllers\InvoiceController;
use App\Http\Controllers\MailAccountController;
use App\Http\Controllers\NoticeOfSaleController;
use App\Http\Controllers\SuggestionController;
use App\Http\Controllers\TradeSheetController;
use App\Http\Controllers\TransactionController;
use App\Http\Controllers\TransactionDeleteRequestController;
use App\Http\Controllers\TransactionEditRequestController;
use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

// Public auth endpoints (session/cookie based via Sanctum).
Route::post('/register', [AuthController::class, 'register']);   // bootstrap first admin only
Route::post('/login', [AuthController::class, 'login']);
Route::get('/registration-open', [AuthController::class, 'registrationOpen']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', [AuthController::class, 'me']);
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::post('/user/password', [AuthController::class, 'changePassword']);

    // Reference data (any authenticated staff).
    Route::get('/agents', [AgentController::class, 'index']);
    Route::get('/agent-commissions', [AgentController::class, 'commissions']);
    Route::get('/agent-emails', [AgentController::class, 'emails']);
    Route::get('/transaction-types', fn () => response()->json([
        'types' => \App\Models\Transaction::TYPES,
        'listing_types' => \App\Models\Transaction::LISTING_TYPES,
    ]));

    // Type-ahead suggestions from previously saved records.
    Route::get('/suggestions/lawyers', [SuggestionController::class, 'lawyers']);
    Route::get('/suggestions/brokerages', [SuggestionController::class, 'brokerages']);

    // Transactions — reads available to any authenticated user (Dashboard,
    // Analytics, etc. all consume this); writes require transactions:edit.
    Route::get('/transactions', [TransactionController::class, 'index']);
    Route::get('/transactions/{transaction}', [TransactionController::class, 'show']);
    Route::get('/transactions/{transaction}/documents', [DocumentController::class, 'index']);
    Route::get('/documents/{document}/file', [DocumentController::class, 'downloadFile']);
    Route::get('/documents/{document}/files/{index}', [DocumentController::class, 'downloadDocFile']);
    Route::get('/documents/{document}/validation-file', [DocumentController::class, 'downloadValidationFile']);
    Route::get('/transactions/{transaction}/notice-of-sale', [NoticeOfSaleController::class, 'show']);
    Route::get('/transactions/{transaction}/messages', [TransactionController::class, 'messages']);

    // §5.1 edit-approval workflow (DFT / Closed). Admins request; Super Admins approve.
    Route::post('/transactions/{transaction}/edit-requests', [TransactionEditRequestController::class, 'store']);
    Route::middleware('admin')->group(function () {
        Route::post('/edit-requests/{editRequest}/approve', [TransactionEditRequestController::class, 'approve']);
        Route::post('/edit-requests/{editRequest}/reject', [TransactionEditRequestController::class, 'reject']);
    });
    // Admin/manager reviews an agent's pending changes (role checked in-controller).
    Route::post('/transactions/{transaction}/review-agent-changes', [TransactionController::class, 'reviewAgentChanges']);
    Route::post('/transactions/{transaction}/reject-agent-change', [TransactionController::class, 'rejectAgentChange']);
    Route::get('/agent-change-notifications', [TransactionController::class, 'agentChangeNotifications']);

    // Transaction deletion approval workflow (roles checked in-controller).
    Route::post('/transactions/{transaction}/delete-requests', [TransactionDeleteRequestController::class, 'store']);
    Route::post('/delete-requests/{deleteRequest}/forward', [TransactionDeleteRequestController::class, 'forward']);
    Route::post('/delete-requests/{deleteRequest}/approve', [TransactionDeleteRequestController::class, 'approve']);
    Route::post('/delete-requests/{deleteRequest}/reject', [TransactionDeleteRequestController::class, 'reject']);
    Route::post('/transactions/{transaction}/messages', [TransactionController::class, 'postMessage']);

    Route::middleware('screen:transactions,edit')->group(function () {
        Route::post('/transactions', [TransactionController::class, 'store']);
        Route::put('/transactions/{transaction}', [TransactionController::class, 'update']);
        Route::delete('/transactions/{transaction}', [TransactionController::class, 'destroy']);

        Route::put('/transactions/{transaction}/documents', [DocumentController::class, 'bulkUpdate']);
        Route::post('/transactions/{transaction}/documents/{document}/file', [DocumentController::class, 'uploadFile']);
        Route::post('/transactions/{transaction}/documents/{document}/files', [DocumentController::class, 'uploadDocFile']);
        Route::delete('/transactions/{transaction}/documents/{document}/files/{index}', [DocumentController::class, 'deleteDocFile']);
        Route::post('/transactions/{transaction}/documents/{document}/validation-file', [DocumentController::class, 'uploadValidationFile']);
        Route::delete('/transactions/{transaction}/documents/{document}/validation-file', [DocumentController::class, 'deleteValidationFile']);
        Route::delete('/documents/{document}', [DocumentController::class, 'destroy']);
        Route::post('/documents/{document}/restore', [DocumentController::class, 'restore']);

        Route::put('/transactions/{transaction}/notice-of-sale', [NoticeOfSaleController::class, 'save']);
        Route::post('/transactions/{transaction}/notice-of-sale/send', [NoticeOfSaleController::class, 'send']);
        Route::post('/transactions/{transaction}/deposit-receipt/send', [DepositReceiptController::class, 'send']);
        Route::post('/transactions/{transaction}/trade-sheet/send', [TradeSheetController::class, 'send']);
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
        Route::post('/invoices/{invoice}/reminders', [InvoiceController::class, 'recordReminder']);
        Route::post('/invoices/{invoice}/send', [InvoiceController::class, 'send']);
        Route::post('/customers', [CustomerController::class, 'store']);
        Route::put('/customers/{customer}', [CustomerController::class, 'update']);
        Route::delete('/customers/{customer}', [CustomerController::class, 'destroy']);
    });

    // Global audit trail — anyone with the Audit Trail screen (Super Admin always; Admin by default).
    Route::middleware('screen:audit,view')->group(function () {
        Route::get('/audit-logs', [AuditLogController::class, 'index']);
    });

    // User management — administrators only.
    Route::middleware('admin')->group(function () {
        Route::put('/company-settings', [CompanySettingController::class, 'update']);
        Route::get('/users/catalog', [UserController::class, 'catalog']);
        Route::apiResource('users', UserController::class)->except(['show']);

        // Email settings — SMTP sender accounts + per-event templates (Super Admin only).
        Route::get('/mail-accounts', [MailAccountController::class, 'index']);
        Route::post('/mail-accounts', [MailAccountController::class, 'store']);
        Route::put('/mail-accounts/{mailAccount}', [MailAccountController::class, 'update']);
        Route::delete('/mail-accounts/{mailAccount}', [MailAccountController::class, 'destroy']);
        Route::post('/mail-accounts/{mailAccount}/default', [MailAccountController::class, 'setDefault']);
        Route::post('/mail-accounts/{mailAccount}/test', [MailAccountController::class, 'test']);

        Route::get('/email-templates', [EmailTemplateController::class, 'index']);
        Route::put('/email-templates/{emailTemplate}', [EmailTemplateController::class, 'update']);
        Route::post('/email-templates/{emailTemplate}/preview', [EmailTemplateController::class, 'preview']);
        Route::get('/mail-events', [EmailTemplateController::class, 'events']);
    });
});
