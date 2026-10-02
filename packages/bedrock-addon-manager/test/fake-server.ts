import type { WebServer, WebServerSettings } from '../src/web/server.ts';

/** A web server that records what the manager asks of it. */
export class FakeServer implements WebServer {
    started: WebServerSettings[] = [];
    stops = 0;
    ticks = 0;
    failStart: string | undefined;

    start(settings: WebServerSettings): void {
        if (this.failStart) throw new Error(this.failStart);
        this.started.push(settings);
    }

    tick(): void {
        this.ticks++;
    }

    stop(): void {
        this.stops++;
    }
}
