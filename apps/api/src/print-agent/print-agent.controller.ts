import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PrintAgentApiKeyGuard } from './print-agent-api-key.guard';
import { PrintAgentService } from './print-agent.service';

@Controller('print-agent')
@UseGuards(PrintAgentApiKeyGuard)
export class PrintAgentController {
  constructor(private readonly printAgentService: PrintAgentService) {}

  @Get('health')
  health(): unknown {
    return {
      status: 'ok',
      service: 'print-agent',
    };
  }

  @Post('jobs/claim-next')
  async claimNextJob(
    @Body() payload: { agentName?: string; printerNames?: string[] },
  ): Promise<unknown | null> {
    return this.printAgentService.claimNextJob(payload);
  }

  @Get('jobs/:jobId/file')
  async getJobFile(
    @Param('jobId') jobId: string,
    @Query('claimToken') claimToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.printAgentService.getJobFile(jobId, claimToken);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }

  @Post('jobs/:jobId/complete')
  async completeJob(
    @Param('jobId') jobId: string,
    @Body() payload: { claimToken?: string; printerName?: string; systemJobId?: string },
  ): Promise<unknown> {
    return this.printAgentService.completeJob(jobId, payload);
  }

  @Post('jobs/:jobId/fail')
  async failJob(
    @Param('jobId') jobId: string,
    @Body() payload: { claimToken?: string; errorMessage?: string },
  ): Promise<unknown> {
    return this.printAgentService.failJob(jobId, payload);
  }
}
