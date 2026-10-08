import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
@Injectable()
export class Db extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
  async atomic<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15000,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < 4
        ) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }
}
export type Tx = Prisma.TransactionClient;
