import { Module } from '@nestjs/common';
import { PrintAgentController } from './print-agent.controller';
import { PrintAgentApiKeyGuard } from './print-agent-api-key.guard';
import { PrintAgentService } from './print-agent.service';

@Module({
  controllers: [PrintAgentController],
  providers: [PrintAgentService, PrintAgentApiKeyGuard],
})
export class PrintAgentModule {}
