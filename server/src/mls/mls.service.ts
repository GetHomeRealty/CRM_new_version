import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * MLS listings — a thin proxy to an external RESO Web API (OData) feed. The provider URL and
 * bearer token come from the environment; when either is missing the module is "not configured"
 * and every call returns 503 rather than crashing the app (the source threw at import time, which
 * would take the whole API down — we never do that here).
 *
 * The access token stays server-side; the browser only ever talks to our own /api/mls proxy.
 */
@Injectable()
export class MlsService {
  private readonly baseUrl = (process.env.MLS_API_URL || '').trim();
  private readonly token = (process.env.MLS_ACCESS_TOKEN || '').trim();
  private readonly pageSize = 50;

  get configured(): boolean {
    return !!(this.baseUrl && this.token);
  }

  private ensureConfigured(): void {
    if (!this.configured) {
      throw new ServiceUnavailableException({
        /*
         * TD-031 - the reply names the problem, not the server's configuration.
         *
         * This body was returned verbatim to whoever asked, including agents: it named two
         * environment variables and told the reader to restart the API. That is a deployment
         * instruction handed to somebody who cannot act on it, and it describes the shape of the
         * server's configuration to a user who has no business knowing it. All three MLS routes
         * returned it, so an agent met it simply by opening the module.
         *
         * The variable names have not been lost, only moved to where they are useful: they are in
         * this file, three lines below, for whoever wires the integration up.
         *
         * MLS_API_URL and MLS_ACCESS_TOKEN are the two settings this needs.
         */
        error: 'MLS is not connected yet. An administrator needs to finish setting it up before listings and Favorites can be used.',
      });
    }
  }

  /** Escape a value for use inside an OData single-quoted string literal. */
  private odataStr(value: string): string {
    return value.replace(/'/g, "''");
  }

  async search(q: MlsSearchQuery): Promise<MlsSearchResult> {
    this.ensureConfigured();
    const page = Math.max(1, Number(q.page) || 1);
    const skip = (page - 1) * this.pageSize;

    const filters: string[] = [];

    const search = (q.search || '').trim();
    if (search) {
      const terms = search.split(/\s+/).filter(Boolean);
      const perTerm = terms.map((t) => {
        const e = this.odataStr(t);
        return `(contains(UnparsedAddress,'${e}') or contains(City,'${e}') or contains(StateOrProvince,'${e}') or contains(PostalCode,'${e}') or contains(PropertyType,'${e}'))`;
      });
      if (perTerm.length) filters.push(`(${perTerm.join(' and ')})`);
    }

    const priceMin = Number(q.priceMin);
    if (Number.isFinite(priceMin) && priceMin > 0) filters.push(`ListPrice ge ${priceMin}`);
    const priceMax = Number(q.priceMax);
    if (q.priceMax && q.priceMax !== 'any' && Number.isFinite(priceMax) && priceMax > 0) filters.push(`ListPrice le ${priceMax}`);

    if (q.beds && q.beds !== 'any') filters.push(`BedroomsTotal ge ${Number(q.beds) || 0}`);
    if (q.baths && q.baths !== 'any') filters.push(`BathroomsTotalInteger ge ${Number(q.baths) || 0}`);
    if (q.propertyType && q.propertyType !== 'any') filters.push(`PropertyType eq '${this.odataStr(q.propertyType)}'`);
    if (q.status && q.status !== 'any') filters.push(`StandardStatus eq '${this.odataStr(q.status)}'`);

    let orderby = 'ModificationTimestamp desc';
    if (q.sort === 'price_desc') orderby = 'ListPrice desc';
    else if (q.sort === 'price_asc') orderby = 'ListPrice asc';

    const params = [`$top=${this.pageSize}`, `$skip=${skip}`, '$count=true', `$orderby=${encodeURIComponent(orderby)}`];
    if (filters.length) params.push('$filter=' + encodeURIComponent(filters.join(' and ')));

    const data = await this.fetchJson(`${this.baseUrl}?${params.join('&')}`);
    const value = Array.isArray(data.value) ? data.value : [];
    const total = typeof data['@odata.count'] === 'number' ? data['@odata.count'] : value.length;

    return { properties: value, total, page, pageSize: this.pageSize, totalPages: Math.max(1, Math.ceil(total / this.pageSize)) };
  }

  async getOne(key: string): Promise<Record<string, unknown>> {
    this.ensureConfigured();
    const url = `${this.baseUrl}('${this.odataStr(key)}')`;
    return this.fetchJson(url);
  }

  private async fetchJson(url: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } });
    } catch (err) {
      throw new ServiceUnavailableException({ error: `Could not reach the MLS provider: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpException({ error: 'MLS provider returned an error', status: res.status, detail: body.slice(0, 500) }, res.status);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

export interface MlsSearchQuery {
  page?: string;
  search?: string;
  sort?: string;
  priceMin?: string;
  priceMax?: string;
  beds?: string;
  baths?: string;
  propertyType?: string;
  status?: string;
}

export interface MlsSearchResult {
  properties: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
