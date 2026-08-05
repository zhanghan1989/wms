import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { ChangePasswordDto } from './dto/change-password.dto';
import { EnableMfaDto } from './dto/enable-mfa.dto';
import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('deploy-version')
  async deployVersion(@Res({ passthrough: true }) res: Response): Promise<{ deployVersion: string }> {
    res.setHeader('Cache-Control', 'no-store');
    return {
      deployVersion: this.authService.getDeploySessionVersion(),
    };
  }

  @Post('login')
  async login(@Body() payload: LoginDto): Promise<unknown> {
    return this.authService.login(payload.username, payload.password, payload.mfaCode);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(): Promise<{ success: boolean }> {
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.authService.getMe(user.id);
  }

  @Post('me/mfa/setup')
  @UseGuards(JwtAuthGuard)
  async setupMfa(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.authService.setupMfa(user.id);
  }

  @Post('me/mfa/enable')
  @UseGuards(JwtAuthGuard)
  async enableMfa(
    @CurrentUser() user: AuthUser,
    @Body() payload: EnableMfaDto,
  ): Promise<unknown> {
    return this.authService.enableMfa(user.id, payload.code);
  }

  @Post('me/password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() payload: ChangePasswordDto,
    @Req() req: { requestId?: string },
  ): Promise<{ success: true; accessToken: string; deployVersion: string }> {
    return this.authService.changePassword(
      user.id,
      payload.currentPassword,
      payload.newPassword,
      req?.requestId,
    );
  }
}
