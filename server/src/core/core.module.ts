import { Global, Module } from '@nestjs/common';
import { ModuleAccessService } from './module-access.service';
import { AreaGuard } from './area.guard';
import { RolePermissionStore } from './role-permission.store';
import { RolesService } from './roles.service';
import { ResourceAccessService } from './resource-access.service';
import { AuditModule } from '../audit/audit.module';

/**
 * The Core Platform layer.
 *
 * The shared foundation both CRM and Transaction Desk sit on. Module access and licensing live here
 * first because they are what makes the two modules separable — everything else the platform will
 * eventually own (authentication, users, roles, permissions, company settings, audit) already exists
 * and works, and moving it is a code-organisation exercise with no behaviour to gain. It is better
 * done deliberately than as a side effect of adding licensing.
 *
 * Global, so a module can ask what it may show without importing the platform explicitly — the same
 * arrangement PrismaModule already uses.
 */
@Global()
@Module({
  imports: [AuditModule],
  providers: [ModuleAccessService, AreaGuard, RolePermissionStore, RolesService, ResourceAccessService],
  exports: [ModuleAccessService, AreaGuard, RolePermissionStore, RolesService, ResourceAccessService],
})
export class CoreModule {}
