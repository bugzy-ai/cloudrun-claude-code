import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('proxy');

/**
 * SimpleAnthropicProxy - A minimal HTTP proxy that intercepts requests to api.anthropic.com
 * and injects the real API key or OAuth token while Claude Code only sees a dummy token.
 *
 * Security: This prevents Claude Code from accessing the real credentials through
 * environment variable inspection or other means.
 */
export class SimpleAnthropicProxy {
  private server?: http.Server;
  private port: number = 0; // Dynamic port - assigned on listen
  private apiKey?: string;
  private oauthToken?: string;

  constructor(apiKey?: string, oauthToken?: string) {
    if (!apiKey && !oauthToken) {
      throw new Error('Either API key or OAuth token is required for proxy');
    }
    this.apiKey = apiKey;
    this.oauthToken = oauthToken;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((clientReq, clientRes) => {
        const requestUrl = clientReq.url || '/';
        logger.debug(`[Proxy] ${clientReq.method} ${requestUrl}`);

        // When using ANTHROPIC_BASE_URL, Claude SDK sends requests like:
        // GET http://localhost:8765/v1/messages
        // We need to forward to https://api.anthropic.com/v1/messages

        // Parse the path from the request
        let targetUrl: URL;
        try {
          // Reconstruct the full Anthropic API URL with the requested path
          targetUrl = new URL(requestUrl, 'https://api.anthropic.com');
        } catch (err) {
          logger.error(`[Proxy] Invalid URL: ${requestUrl}`);
          clientRes.writeHead(400);
          clientRes.end('Bad Request');
          return;
        }

        // Prepare headers with injected credentials
        const headers: http.OutgoingHttpHeaders = {
          ...clientReq.headers,
          'host': targetUrl.hostname
        };

        // Inject authentication based on what header Claude sent
        // This allows Claude to determine the auth type based on env vars
        if (headers['x-api-key']) {
          // Claude sent x-api-key (from ANTHROPIC_API_KEY env var)
          if (this.apiKey) {
            headers['x-api-key'] = this.apiKey;
            logger.debug(`[Proxy] Replacing x-api-key with real API key: ${this.apiKey.substring(0, 20)}...`);
          } else {
            logger.error('[Proxy] WARNING: Claude sent x-api-key but we have no API key to inject!');
          }
          delete headers['authorization']; // Ensure no conflicting auth
        } else if (headers['authorization']) {
          // Claude sent authorization header (from CLAUDE_CODE_OAUTH_TOKEN env var)
          if (this.oauthToken) {
            headers['authorization'] = `Bearer ${this.oauthToken}`;
            logger.debug(`[Proxy] Replacing authorization with real OAuth token: ${this.oauthToken.substring(0, 30)}...`);
          } else {
            logger.error('[Proxy] WARNING: Claude sent authorization but we have no OAuth token to inject!');
          }
          delete headers['x-api-key']; // Ensure no conflicting auth
        } else {
          logger.error('[Proxy] WARNING: Claude sent neither x-api-key nor authorization header!');
        }

        // Remove proxy-specific headers
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];

        // Prepare proxy request options
        const options: https.RequestOptions = {
          hostname: targetUrl.hostname,
          port: 443,
          path: targetUrl.pathname + targetUrl.search,
          method: clientReq.method,
          headers: headers
        };

        // Forward request to Anthropic API
        const proxyReq = https.request(options, (proxyRes) => {
          // Log response status
          logger.debug(`[Proxy] Response: ${proxyRes.statusCode} ${proxyRes.statusMessage}`);

          // Forward response headers and status
          clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

          // Pipe response body
          proxyRes.pipe(clientRes);
        });

        // Handle proxy request errors
        proxyReq.on('error', (err) => {
          logger.error('[Proxy] Request error:', err.message);
          if (!clientRes.headersSent) {
            clientRes.writeHead(502);
            clientRes.end('Bad Gateway');
          }
        });

        // Pipe request body
        clientReq.pipe(proxyReq);

        // Handle client errors
        clientReq.on('error', (err) => {
          logger.error('[Proxy] Client error:', err.message);
          proxyReq.destroy();
        });
      });

      this.server.listen(0, '127.0.0.1', () => {
        // Get the dynamically assigned port
        const address = this.server!.address();
        if (typeof address === 'object' && address) {
          this.port = address.port;
        }
        logger.debug(`[Proxy] ✓ Started on 127.0.0.1:${this.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        logger.error('[Proxy] Server error:', err);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.debug('[Proxy] ✓ Stopped');
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }
}
