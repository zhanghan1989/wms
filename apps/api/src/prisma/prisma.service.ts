import { Injectable, OnModuleInit } from '@nestjs/common';
import { installCompanyIsolation } from '../company-scope/company-prisma';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
    return installCompanyIsolation(this) as this;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
