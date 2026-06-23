<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Customer extends Model
{
    protected $fillable = ['name', 'address', 'city', 'province', 'postal_code', 'country', 'email', 'phone'];
}
