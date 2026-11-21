/** A platform Back event has already passed the OS keyboard/external Activity handling. */
export interface BackPort {
    listenBack(listener: () => void): Promise<() => Promise<void>>;
    /** Leave the foreground root without destroying acknowledged records or replaying actions. */
    leaveRoot(): Promise<void>;
}
