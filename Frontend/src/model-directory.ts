export interface DirectoryState { loading: boolean; models: string[]; error?: string }
type DirectoryResponse = { models: { id: string }[] };

/** Shares one request per Provider and rejects results from superseded settings or refreshes. */
export class ModelDirectories {
  private entries = new Map<string, DirectoryState>();
  private requests = new Map<string, symbol>();
  private closed = false;
  constructor(private readonly request: (id: string) => Promise<DirectoryResponse>, private readonly changed: () => void) {}
  get(id: string): DirectoryState | undefined { return this.entries.get(id); }
  async load(id: string, refresh = false): Promise<void> {
    if (this.closed || (!refresh && this.entries.has(id))) return;
    const token = Symbol(id);
    this.requests.set(id, token);
    this.entries.set(id, { loading: true, models: [] }); this.changed();
    try {
      const response = await this.request(id);
      if (this.closed || this.requests.get(id) !== token) return;
      this.entries.set(id, { loading: false, models: response.models.map(model => model.id),
        ...(response.models.length ? {} : { error: 'Provider 返回了空模型目录，可继续手动输入。' }) });
    } catch (error) {
      if (this.closed || this.requests.get(id) !== token) return;
      this.entries.set(id, { loading: false, models: [], error: error instanceof Error ? error.message : '模型目录读取失败' });
    }
    this.changed();
  }
  dispose(): void { this.closed = true; this.requests.clear(); }
}
