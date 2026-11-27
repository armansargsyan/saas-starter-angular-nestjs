import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { LinksService } from './links.service';

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Link not found</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 1rem">
<h1>Link not found</h1><p>This short link doesn't exist or was deleted.</p>
</body></html>`;

/** Public short links: `GET /r/:code` (outside the /api prefix). */
@Public()
@Controller('r')
export class RedirectController {
  constructor(private readonly links: LinksService) {}

  @Get(':code')
  async redirect(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Express routes case-insensitively; only the exact `/r/` prefix is a
    // short link, so `/R/...` can't slip past the self-link check.
    const isShortLinkPath = req.path.startsWith('/r/');
    const target = !isShortLinkPath
      ? null
      : await this.links.resolveRedirect({
          code,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          referrer: req.get('referer'),
          // Express serves HEAD through GET routes; link checkers use HEAD.
          countClick: req.method === 'GET',
        });

    // Never cached, so every click reaches us and is counted; and don't leak
    // the short-link URL to the target site.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!target) {
      res.status(404).type('html').send(NOT_FOUND_PAGE);
      return;
    }
    res.redirect(302, target);
  }
}
