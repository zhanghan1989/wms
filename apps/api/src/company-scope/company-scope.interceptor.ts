import { isWarehouseRakutenRoute } from './warehouse-rakuten-routes';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthUser } from '../common/types/auth-user.type';
import { companyContext } from './company-context';

@Injectable()
export class CompanyScopeInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{
      user?: AuthUser; headers: Record<string, unknown>; method: string; originalUrl: string;
    }>();
    if (!req.user) return next.handle();
    const user = req.user;
    const systemAdmin = user.role === 'system_admin';
    const warehouse = user.department === 'overseas_warehouse';
    const selected = req.headers['x-company-id'];
    if (selected !== undefined && (typeof selected !== 'string' || !/^[1-9]\d*$/.test(selected))) {
      throw new BadRequestException('公司编号无效');
    }
    let companyId = systemAdmin || warehouse ? undefined : user.companyId;
    if (selected) {
      if (!systemAdmin && !warehouse && selected !== String(user.companyId)) {
        throw new ForbiddenException('无权访问其他公司');
      }
      companyId = BigInt(String(selected));
    }
    if (!systemAdmin && !warehouse && !companyId) throw new ForbiddenException('账号尚未分配公司');
    const path = req.originalUrl.split('?')[0].replace(/^\/api\//, '');
    const globalAdminPath = systemAdmin && /^(auth|companies|backups|branding|user-options)(\/|$)/.test(path);
    if (globalAdminPath) companyId = undefined;
    if ((warehouse || systemAdmin) && !globalAdminPath && !companyId && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && !/^(auth|companies)(\/|$)/.test(path)) {
      throw new BadRequestException('请先选择所属中国公司，再处理业务');
    }
    if (companyId && !/^(auth|companies)(\/|$)/.test(path)) {
      const company = await this.prisma.company.findUnique({ where: { id: companyId } });
      if (!company || company.status !== 1) throw new ForbiddenException('公司不存在或已禁用');
    }
    // Manual orders need shop/platform names, not connection credentials or write access.
    const warehouseOrderReferenceRead = req.method === 'GET'
      && (path === 'shops' || path === 'shops/platforms');
    // Warehouse authority is limited to warehouse operations, never global administration.
    if (!systemAdmin && warehouse && !warehouseOrderReferenceRead && !isWarehouseRakutenRoute(req.method, path) && !/^(auth(?:\/|$)|companies$|user-options$|skus(?:\/|$)|sku-edit-requests(?:\/|$)|master-products(?:\/|$)|inventory(?:\/|$)|boxes(?:\/|$)|shelves(?:\/|$)|inbound(?:\/|$)|batch-inbound(?:\/|$)|orders(?:\/|$)|stocktake-planner(?:\/|$)|return-records(?:\/|$)|print-agent(?:\/|$)|audit-logs(?:\/|$)|brands$|shops$|sku-types$)/.test(path)) {
      throw new ForbiddenException('海外仓账号仅允许访问仓储业务');
    }
    if (!systemAdmin && warehouse && /^(brands|shops|sku-types)$/.test(path) && req.method !== 'GET') {
      throw new ForbiddenException('海外仓账号不能修改公司基础资料');
    }
    if (!systemAdmin && path.startsWith('user-options') && req.method !== 'GET') {
      throw new ForbiddenException('只有系统管理员可以管理全局部门配置');
    }
    if (!systemAdmin && /^(backups|branding)(\/|$)/.test(path) && !(path === 'branding' && req.method === 'GET')) {
      throw new ForbiddenException('仅系统管理员可以管理全局配置和备份');
    }
    return new Observable((subscriber) => companyContext.run({
      companyId, systemAdmin, warehouse, userId: user.id,
    }, () => {
      const subscription = next.handle().subscribe(subscriber);
      return () => subscription.unsubscribe();
    }));
  }
}
