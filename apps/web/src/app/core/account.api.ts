import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ProfileResponse,
  UpdateProfileRequest,
} from '@saas-starter/shared';
import { apiResult, type ApiResult } from './api-result';

/** The caller's own account. */
@Injectable({ providedIn: 'root' })
export class AccountApi {
  private readonly http = inject(HttpClient);

  updateProfile(
    profile: UpdateProfileRequest,
  ): Promise<ApiResult<ProfileResponse>> {
    return apiResult(
      this.http.patch<ProfileResponse>('/api/account/profile', profile),
    );
  }

  /** Cancels subscriptions and deletes the account and its data. */
  deleteAccount(): Promise<ApiResult<unknown>> {
    return apiResult(this.http.delete('/api/account'));
  }
}
