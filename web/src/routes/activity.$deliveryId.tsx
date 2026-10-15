import { createFileRoute } from '@tanstack/react-router';
import { DeliveryPage } from '../deliveries/DeliveryPage';

/** A delivery's own address (ADR 0056); an id the workspace does not own renders the shell 404. */
export const Route = createFileRoute('/activity/$deliveryId')({ component: DeliveryPage });
