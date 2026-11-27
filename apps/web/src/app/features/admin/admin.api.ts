import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AdminUser, ImpersonationResponse } from '@saas-starter/shared';
import { apiResult, type ApiResult } from '../../core/api-result';

/** Admin mutations (reads use httpResource in the components). */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);

  ban(uid: string): Promise<ApiResult<AdminUser>> {
    return apiResult(this.http.post<AdminUser>(`${user(uid)}/ban`, null));
  }

  unban(uid: string): Promise<ApiResult<AdminUser>> {
    return apiResult(this.http.post<AdminUser>(`${user(uid)}/unban`, null));
  }

  impersonate(uid: string): Promise<ApiResult<ImpersonationResponse>> {
    return apiResult(
      this.http.post<ImpersonationResponse>(`${user(uid)}/impersonate`, null),
    );
  }
}

const user = (uid: string) => `/api/admin/users/${encodeURIComponent(uid)}`;
