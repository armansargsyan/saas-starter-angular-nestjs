/** Response of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}
