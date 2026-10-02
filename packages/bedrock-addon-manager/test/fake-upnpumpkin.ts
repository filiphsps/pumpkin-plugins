import {
    decodeRequest,
    encodeReply,
    type PortStatus,
    type Request,
    type SendMessage
} from '@pumpkin-plugins/upnpumpkin-api';

/** Stands in for the UPnPumpkin plugin: records what it is asked and answers with a status the test sets. */
export class FakeUpnpumpkin {
    /** What `ensure` and `status` answer with. */
    status: PortStatus = { kind: 'pending' };
    /** False makes every message fail, as when the plugin isn't loaded. */
    available = true;
    /** Every request received, in order. */
    readonly requests: Request[] = [];

    /** The IPC call to give the code under test. */
    readonly send: SendMessage = (recipient, bytes) => {
        if (!this.available || recipient !== 'UPnPumpkin') throw new Error(`plugin ${recipient} is not loaded`);
        const decoded = decodeRequest(bytes);
        if (!('request' in decoded)) throw new Error('garbage');
        this.requests.push(decoded.request);
        return encodeReply({ ok: true, status: this.status });
    };

    /** The operations received, for short assertions. */
    get ops(): string[] {
        return this.requests.map((r) => r.op);
    }
}
