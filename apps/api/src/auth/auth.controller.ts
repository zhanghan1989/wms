import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() payload: LoginDto): Promise<unknown> {
    return this.authService.login(payload.username, payload.password);
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

  @Post('me/password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() payload: ChangePasswordDto,
    @Req() req: { requestId?: string },
  ): Promise<{ success: boolean }> {
    return this.authService.changePassword(
      user.id,
      payload.currentPassword,
      payload.newPassword,
      req?.requestId,
    );
  }
}
