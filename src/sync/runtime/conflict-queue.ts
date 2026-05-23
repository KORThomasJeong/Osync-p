export interface ConflictQueueItem {
  id: string;
  entryId: string;
  op: "upsert" | "delete";
  reason: string;
  originalPath: string;
  conflictPath: string | null;
  createdAt: number;
  seq: number;
}

export interface ConflictQueueEvent {
  entryId: string;
  op: "upsert" | "delete";
  reason?: string;
  originalPath: string;
  conflictPath: string | null;
}

export interface ConflictQueueSource {
  list(): ConflictQueueItem[];
  count(): number;
  dismiss(id: string): void;
  clear(): void;
  onChange(callback: () => void): () => void;
}

export class SyncConflictQueue implements ConflictQueueSource {
  private readonly items = new Map<string, ConflictQueueItem>();
  private readonly listeners = new Set<() => void>();
  private nextSeq = 0;

  enqueue(event: ConflictQueueEvent): ConflictQueueItem {
    this.nextSeq += 1;
    const id = `${event.entryId}:${this.nextSeq}`;
    const item: ConflictQueueItem = {
      id,
      entryId: event.entryId,
      op: event.op,
      reason: event.reason ?? "unknown",
      originalPath: event.originalPath,
      conflictPath: event.conflictPath,
      createdAt: Date.now(),
      seq: this.nextSeq,
    };
    this.items.set(id, item);
    this.emit();
    return item;
  }

  list(): ConflictQueueItem[] {
    return [...this.items.values()].sort((left, right) => right.seq - left.seq);
  }

  count(): number {
    return this.items.size;
  }

  dismiss(id: string): void {
    if (this.items.delete(id)) {
      this.emit();
    }
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.emit();
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[osync] conflict-queue listener failed", error);
      }
    }
  }
}
