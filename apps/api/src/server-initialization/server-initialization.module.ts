import { Module } from '@nestjs/common';
import { ServerProvisionModule } from '../server-provision/server-provision.module';

/**
 * Kept for AppModule import stability / discovery.
 * Routes live on ServerProvisionController (same /projects/:projectId/server prefix).
 */
@Module({
  imports: [ServerProvisionModule],
  exports: [ServerProvisionModule],
})
export class ServerInitializationModule {}
