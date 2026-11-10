export type PageLoadMode = 'replace' | 'append';

export type PagedRequest = {
  id: number;
  signal: AbortSignal;
};

export class PaginatedRequestGate {
  private activeController: AbortController | null = null;
  private activeRequestId = 0;
  private appendInFlight = false;

  begin(mode: PageLoadMode): PagedRequest | null {
    if (mode === 'append' && this.appendInFlight) {
      return null;
    }

    this.activeController?.abort();
    this.activeController = new AbortController();
    this.activeRequestId += 1;
    this.appendInFlight = mode === 'append';

    return {
      id: this.activeRequestId,
      signal: this.activeController.signal,
    };
  }

  complete(requestId: number, mode: PageLoadMode): void {
    if (requestId !== this.activeRequestId) {
      return;
    }

    if (mode === 'append') {
      this.appendInFlight = false;
    }
    this.activeController = null;
  }

  abort(): void {
    this.activeController?.abort();
    this.activeController = null;
    this.appendInFlight = false;
    this.activeRequestId += 1;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.activeRequestId;
  }
}
