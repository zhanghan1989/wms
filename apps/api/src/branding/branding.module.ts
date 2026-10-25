import { BadRequestException, Body, Controller, Get, Module, Put, UseGuards } from '@nestjs/common';
import { IsString, Length, Matches, MaxLength } from 'class-validator';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

export const BRANDING_DEFAULTS = { siteName: '库存管理系统', logo: '', themeColor: '#0f8a5f' };

export class UpdateBrandingDto {
  @IsString()
  @Length(1, 60)
  siteName!: string;

  @IsString()
  @MaxLength(90000)
  @Matches(/^(?:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2})?$/)
  logo!: string;

  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  themeColor!: string;
}

@Controller('branding')
export class BrandingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(): Promise<unknown> {
    const saved = await this.prisma.siteBranding.findUnique({ where: { id: 1 } });
    return { settings: saved ?? BRANDING_DEFAULTS, defaults: BRANDING_DEFAULTS };
  }

  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.system_admin)
  async update(@Body() body: UpdateBrandingDto): Promise<unknown> {
    const siteName = body.siteName.trim();
    if (!siteName) throw new BadRequestException('网站名称不能为空');
    const data = { siteName, logo: body.logo, themeColor: body.themeColor };
    const settings = await this.prisma.siteBranding.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    return { settings, defaults: BRANDING_DEFAULTS };
  }
}

@Module({ controllers: [BrandingController] })
export class BrandingModule {}
