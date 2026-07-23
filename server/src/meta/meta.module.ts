import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetaController } from './meta.controller';
import { MetaPublicController } from './meta-public.controller';
import { MetaConnectionService } from './meta-connection.service';
import { MetaGraphService } from './meta-graph.service';
import { MetaSyncService } from './meta-sync.service';
import { MetaStateService } from './meta-state.service';
import { LeadAuditService } from '../leads/lead-audit.service';

/**
 * Meta (Facebook / Instagram) lead ads. Synced leads land in the `leads` table with
 * `source = 'facebook_meta'`, so the Lead module manages them like any other lead.
 *
 * MetaPublicController is registered BEFORE MetaController so its unguarded literal paths
 * (`meta/callback`, `meta/webhook`) win — Express matches in registration order, and behind the
 * guarded controller Facebook's own callbacks would be rejected as unauthenticated.
 */
@Module({
  imports: [AuthModule],
  controllers: [MetaPublicController, MetaController],
  providers: [MetaConnectionService, MetaGraphService, MetaSyncService, MetaStateService, LeadAuditService],
  exports: [MetaSyncService, MetaConnectionService],
})
export class MetaModule {}
