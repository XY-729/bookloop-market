import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ContentSafety, decryptWxMessage, verifyWxSignature } from './content-safety';
import { parse, text } from './validation';
@ApiTags('微信消息推送')
@Controller('v1/wechat')
export class WechatController {
  constructor(@Inject(ContentSafety) private safety: ContentSafety) {}
  @Get('events') @ApiOperation({ summary: '微信后台消息推送地址验证' }) verify(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ) {
    const echo = parse(text(350000), query.echostr);
    verifyWxSignature(query, query.msg_signature ? echo : undefined);
    response.type('text/plain').send(query.msg_signature ? decryptWxMessage(echo) : echo);
  }
  @Post('events')
  @HttpCode(200)
  @ApiOperation({ summary: '接收 JSON 加密格式的图片安全检测回调' })
  async event(
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    await this.safety.event(query, body);
    response.type('text/plain').send('success');
  }
}
