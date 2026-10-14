import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { ClientReviewsController, ClientReviewResponseController } from './client-reviews.controller';
import { ClientReviewsService } from './client-reviews.service';
@Module({ imports: [AuthModule, EmailModule], controllers: [ClientReviewsController, ClientReviewResponseController], providers: [ClientReviewsService] })
export class ClientReviewsModule {}
