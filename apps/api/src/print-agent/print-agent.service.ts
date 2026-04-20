import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrintJobStatus } from '@prisma/client';
import { readFile, stat } from 'fs/promises';
import { parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

type ClaimPrintJobPayload = {
  agentName?: string;
  printerNames?: string[];
};

type CompletePrintJobPayload = {
  claimToken?: string;
  printerName?: string;
  systemJobId?: string;
};

type FailPrintJobPayload = {
  claimToken?: string;
  errorMessage?: string;
};

@Injectable()
export class PrintAgentService {
  constructor(private readonly prisma: PrismaService) {}

  async claimNextJob(payload: ClaimPrintJobPayload): Promise<unknown | null> {
    const agentName = String(payload?.agentName ?? '').trim() || 'print-agent';
    const printerNames = Array.isArray(payload?.printerNames)
      ? payload.printerNames
          .map((item) => String(item ?? '').trim())
          .filter((item) => item.length > 0)
      : [];
    const where = printerNames.length
      ? {
          status: PrintJobStatus.pending,
          filePath: {
            not: null,
          },
          OR: [
            { printerName: null },
            {
              printerName: {
                in: printerNames,
              },
            },
          ],
        }
      : {
          status: PrintJobStatus.pending,
          filePath: {
            not: null,
          },
        };

    const candidates = await this.prisma.printJob.findMany({
      where,
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });

    for (const job of candidates) {
      const claimToken = randomUUID().replace(/-/g, '');
      const result = await this.prisma.printJob.updateMany({
        where: {
          id: job.id,
          status: PrintJobStatus.pending,
          filePath: {
            not: null,
          },
        },
        data: {
          status: PrintJobStatus.claimed,
          claimedAt: new Date(),
          failedAt: null,
          completedAt: null,
          errorMessage: null,
          agentName,
          claimToken,
        },
      });
      if (result.count !== 1) {
        continue;
      }

      const claimedJob = await this.prisma.printJob.findUnique({
        where: { id: job.id },
      });
      if (!claimedJob) {
        continue;
      }
      return {
        id: claimedJob.id.toString(),
        jobType: claimedJob.jobType,
        productId: claimedJob.productId,
        printerName: claimedJob.printerName ?? null,
        fileName: claimedJob.fileName,
        trackingNo: claimedJob.trackingNo ?? null,
        claimToken,
        queuedAt: claimedJob.queuedAt.toISOString(),
      };
    }

    return null;
  }

  async getJobFile(jobIdRaw: string, claimTokenRaw?: string): Promise<{ fileName: string; content: Buffer }> {
    const jobId = parseId(jobIdRaw, 'jobId');
    const claimToken = String(claimTokenRaw ?? '').trim();
    if (!claimToken) {
      throw new BadRequestException('claimToken 不能为空');
    }

    const job = await this.prisma.printJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.status !== PrintJobStatus.claimed || String(job.claimToken ?? '') !== claimToken) {
      throw new NotFoundException('未找到可下载的打印任务文件');
    }
    if (!job.filePath) {
      throw new BadRequestException('该打印任务缺少文件路径');
    }

    try {
      await stat(job.filePath);
    } catch {
      throw new BadRequestException('打印任务文件不存在');
    }

    return {
      fileName: job.fileName,
      content: await readFile(job.filePath),
    };
  }

  async completeJob(jobIdRaw: string, payload: CompletePrintJobPayload): Promise<unknown> {
    const jobId = parseId(jobIdRaw, 'jobId');
    const claimToken = String(payload?.claimToken ?? '').trim();
    if (!claimToken) {
      throw new BadRequestException('claimToken 不能为空');
    }

    const job = await this.prisma.printJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.status !== PrintJobStatus.claimed || String(job.claimToken ?? '') !== claimToken) {
      throw new NotFoundException('未找到待完成的打印任务');
    }

    const printerName = String(payload?.printerName ?? '').trim();
    const systemJobId = String(payload?.systemJobId ?? '').trim();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.printJob.updateMany({
        where: {
          id: job.id,
          status: PrintJobStatus.claimed,
          claimToken,
        },
        data: {
          status: PrintJobStatus.completed,
          completedAt: new Date(),
          errorMessage: null,
          printerName: printerName || job.printerName,
          systemJobId: systemJobId || job.systemJobId,
        },
      });
      if (updated.count !== 1) {
        throw new BadRequestException('打印任务状态已变更，请重新获取任务');
      }

      if (job.batchPageId) {
        const pageUpdated = await tx.yamatoShipmentBatchPage.updateMany({
          where: {
            id: job.batchPageId,
            printedAt: null,
          },
          data: {
            printedAt: new Date(),
            printedProductId: job.productId,
          },
        });
        if (pageUpdated.count !== 1) {
          throw new BadRequestException('面单页已被其他操作标记为已打印');
        }
      }
    });

    return {
      id: job.id.toString(),
      status: 'completed',
    };
  }

  async failJob(jobIdRaw: string, payload: FailPrintJobPayload): Promise<unknown> {
    const jobId = parseId(jobIdRaw, 'jobId');
    const claimToken = String(payload?.claimToken ?? '').trim();
    if (!claimToken) {
      throw new BadRequestException('claimToken 不能为空');
    }

    const job = await this.prisma.printJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.status !== PrintJobStatus.claimed || String(job.claimToken ?? '') !== claimToken) {
      throw new NotFoundException('未找到待失败回报的打印任务');
    }

    await this.prisma.printJob.updateMany({
      where: {
        id: job.id,
        status: PrintJobStatus.claimed,
        claimToken,
      },
      data: {
        status: PrintJobStatus.failed,
        failedAt: new Date(),
        errorMessage: String(payload?.errorMessage ?? '').trim().slice(0, 255) || '打印失败',
      },
    });

    return {
      id: job.id.toString(),
      status: 'failed',
    };
  }
}
