import type { Channel } from 'amqplib';
import { realtimeRoutingKey, SUBMISSION_EVENTS_EXCHANGE, type RealtimeEvent } from './events.js';

export function publishRealtimeEvent(channel: Channel, event: RealtimeEvent): void {
  channel.publish(
    SUBMISSION_EVENTS_EXCHANGE,
    realtimeRoutingKey(event),
    Buffer.from(JSON.stringify(event)),
    { contentType: 'application/json', persistent: false, type: event.type },
  );
}
