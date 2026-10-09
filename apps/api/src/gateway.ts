import { Inject } from '@nestjs/common';
import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets';
import { WebSocket } from 'ws';
import { IncomingMessage } from 'node:http';
import { Auth, requireVerified } from './auth';
import { Events } from './events';
import { Legal } from './legal';
@WebSocketGateway({ path: '/v1/ws' })
export class Gateway implements OnGatewayConnection {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(Events) private events: Events,
    @Inject(Legal) private legal: Legal,
  ) {}
  async handleConnection(socket: WebSocket, request: IncomingMessage) {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    try {
      if (!token) throw new Error();
      const actor = await this.auth.actor(token);
      requireVerified(actor);
      await this.legal.ensure(actor.id);
      this.events.attach(actor.id, socket);
      socket.send(JSON.stringify({ event: 'ready' }));
      const timer = setInterval(async () => {
        try {
          const current = await this.auth.actor(token);
          requireVerified(current);
          await this.legal.ensure(current.id);
          if (socket.readyState === 1) socket.ping();
        } catch {
          socket.close(1008, 'Authentication expired');
        }
      }, 30000);
      socket.on('close', () => clearInterval(timer));
    } catch {
      socket.close(1008, 'Authentication required');
    }
  }
}
