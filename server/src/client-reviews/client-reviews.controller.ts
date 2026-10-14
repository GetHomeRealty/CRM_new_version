import { Body, Controller, Get, Header, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { ClientReviewsService } from './client-reviews.service';
@Controller('client-reviews')
@UseGuards(AuthGuard, ScreenGuard)
export class ClientReviewsController {
  constructor(private readonly reviews: ClientReviewsService) {}
  @Header('Cache-Control', 'no-store')
  @Get() @Screen('reviews', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query('before') before?: string) { return this.reviews.list(user, before === undefined ? undefined : Number(before)); }
  @Header('Cache-Control', 'no-store')
  @Get('mailboxes') @Screen('reviews', 'edit')
  mailboxes(@CurrentUser() user: AuthUserRecord) { return this.reviews.mailboxes(user); }
  @Header('Cache-Control', 'no-store')
  @Get('choices') @Screen('reviews', 'edit')
  choices(@CurrentUser() user: AuthUserRecord, @Query('search') search?: string) { return this.reviews.choices(user, search || ''); }
  @Header('Cache-Control', 'no-store')
  @Post('requests') @Screen('reviews', 'edit')
  request(@CurrentUser() user: AuthUserRecord, @Body() body: Parameters<ClientReviewsService['request']>[1]) { return this.reviews.request(user, body); }
  @Header('Cache-Control', 'no-store')
  @Get('requests/:id/link') @Screen('reviews', 'edit')
  link(@CurrentUser() user: AuthUserRecord, @Param('id') id: string, @Res({ passthrough: true }) res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.reviews.link(user, Number(id)); }
  @Header('Cache-Control', 'no-store')
  @Post('requests/:id/cancel') @Screen('reviews', 'edit')
  cancel(@CurrentUser() user: AuthUserRecord, @Param('id') id: string) { return this.reviews.cancel(user, Number(id)); }
}
/** No staff session: the 256-bit link capability is the sole authority for submission. */
@Controller('client-reviews')
export class ClientReviewResponseController {
  constructor(private readonly reviews: ClientReviewsService) {}
  @Header('Cache-Control', 'no-store')
  @Post('submit')
  submit(@Body() body: Parameters<ClientReviewsService['submit']>[0]) { return this.reviews.submit(body); }
  @Header('Cache-Control', 'no-store')
  @Get('respond')
  form(@Res() res: Response) {
    const nonce = randomBytes(24).toString('base64');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Get Home Hub · Client review</title><h1>Share your experience</h1><p>Your feedback is private to the staff member who requested it. It is not published. Please leave out sensitive financial or identity details.</p><form id="review"><p><label>Rating <select id="rating" required><option value="">Choose a rating</option><option value="1">1 star</option><option value="2">2 stars</option><option value="3">3 stars</option><option value="4">4 stars</option><option value="5">5 stars</option></select></label></p><p><label>Your review<br><textarea id="comment" maxlength="5000" rows="8" required></textarea></label></p><button id="submit">Submit review</button></form><p id="status" role="status"></p><script nonce="${nonce}">
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);const form=document.getElementById('review'),status=document.getElementById('status'),button=document.getElementById('submit');
if(!/^[a-f0-9]{64}$/.test(token)){form.hidden=true;status.textContent='Review link is unavailable.';}
form.addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;button.disabled=true;status.textContent='Submitting…';try{const response=await fetch('/api/client-reviews/submit',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,rating:Number(document.getElementById('rating').value),comment:document.getElementById('comment').value})});const data=await response.json();if(!response.ok)throw new Error(typeof data.message==='string'?data.message:'Review unavailable.');form.hidden=true;status.textContent='Thank you. Your review has been submitted.';}catch(error){status.textContent=error.message||'Submission could not be confirmed. Your link can be used only once.';button.disabled=false;}});
</script></html>`);
  }
}
