/**
 * A place in the session's turn-start queue. Release it once the turn ends.
 * Skip `await wait` when `needsWait` is false to preserve synchronous prompt setup.
 */
export interface TurnStartReservation {
    wait: Promise<void>;
    needsWait: boolean;
    release: () => void;
}
