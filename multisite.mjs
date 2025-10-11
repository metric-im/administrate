import express from 'express';
import tls from 'tls';
import { Config } from './config.mjs';
import moment from 'moment';
import fs from "fs";
import {resolve} from "path";
import child_process from "child_process";
import axios from 'axios';

const MAX_AGE = 75; // days
const MAX_WAIT_TIME = 60; // seconds

export class MultiSite {
    constructor(app,options) {
        this.app = app;
        this.options = options || {};
        this.sites = {};
        this._spawnPort = (parseInt(this.options.spawnPort||0) || 53874);
        this.usedPorts = new Set();
        this.healthCheckIntervals = new Map();
        this.isShuttingDown = false;
        this.errorLogTracker = new Map(); // Track error frequency for rate limiting
        this.setupCleanup();
    }
    get spawnPort() {
        const port = this._spawnPort++;
        this.usedPorts.add(port);
        return port;
    }

    setupCleanup() {
        // Set up centralized signal handlers that host applications can use
        this.gracefulShutdown = this.gracefulShutdown.bind(this);

        // Only handle the 'exit' event for emergency cleanup
        process.on('exit', () => {
            // Synchronous cleanup only - no async operations allowed in 'exit'
            console.log('Emergency cleanup on exit...');
            Object.values(this.sites).forEach((site) => {
                if (site.proc && !site.proc.killed) {
                    site.proc.kill('SIGKILL');
                }
            });
        });
    }

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) {
            console.log(`Received ${signal} again, forcing exit...`);
            process.exit(1);
        }

        this.isShuttingDown = true;
        console.log(`Received ${signal}, shutting down gracefully...`);

        try {
            console.log("Cleaning up child processes...");
            await this.cleanup();

            console.log("Graceful shutdown complete");
            process.exit(0);
        } catch (error) {
            console.error("Error during shutdown:", error);
            process.exit(1);
        }
    }

    setupSignalHandlers() {
        // Method host applications can call to set up proper signal handling
        process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
        console.log('MultiSite signal handlers installed');
    }

    async cleanup() {
        console.log('Cleaning up spawned processes...');

        // Set a global timeout for the entire cleanup process
        const cleanupTimeout = setTimeout(() => {
            console.log('Cleanup taking too long, forcing exit...');
            process.exit(1);
        }, 15000); // 15 second total timeout

        const promises = Object.values(this.sites).map(async (site) => {
            if (site.proc && !site.proc.killed) {
                return new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        if (!site.proc.killed) {
                            console.log(`Force killing ${site.name} after timeout`);
                            site.proc.kill('SIGKILL');
                        }
                        resolve();
                    }, 5000); // Reduced to 5 second timeout per process

                    site.proc.kill('SIGTERM');

                    site.proc.on('exit', () => {
                        console.log(`${site.name} process terminated gracefully`);
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
        });

        await Promise.all(promises.filter(Boolean));

        // Clear all health check intervals
        this.healthCheckIntervals.forEach(interval => clearInterval(interval));
        this.healthCheckIntervals.clear();

        clearTimeout(cleanupTimeout);
        console.log('All spawned processes cleaned up');
    }

    startHealthCheck(site) {
        const intervalId = setInterval(async () => {
            if (!site.proc || site.proc.killed) {
                clearInterval(intervalId);
                this.healthCheckIntervals.delete(site.name);
                return;
            }

            try {
                await axios.get(`http://127.0.0.1:${site.options.env.PORT}/health`, {
                    timeout: 5000,
                    validateStatus: () => true
                });
            } catch (error) {
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    console.log(`Health check failed for ${site.name}, marking for restart...`);
                    clearInterval(intervalId);
                    this.healthCheckIntervals.delete(site.name);

                    // Mark the process as failed for cleanup
                    if (site.proc && !site.proc.killed) {
                        site.proc.kill('SIGTERM');
                    }
                }
            }
        }, 30000); // Check every 30 seconds

        this.healthCheckIntervals.set(site.name, intervalId);
    }

    restartSite(domain) {
        const oldSite = this.sites[domain];
        if (oldSite) {
            // Clear health check
            const intervalId = this.healthCheckIntervals.get(oldSite.name);
            if (intervalId) {
                clearInterval(intervalId);
                this.healthCheckIntervals.delete(oldSite.name);
            }

            // Kill old process
            if (oldSite.proc && !oldSite.proc.killed) {
                oldSite.proc.kill('SIGTERM');
            }

            // Remove from used ports
            this.usedPorts.delete(oldSite.options.env.PORT);
        }

        // Create new site
        this.sites[domain] = Site.Clone(domain, this);
        console.log(`Restarted site for domain: ${domain}`);
    }

    removeDeadSites() {
        Object.keys(this.sites).forEach(domain => {
            const site = this.sites[domain];
            if (site.proc && site.proc.killed) {
                this.usedPorts.delete(site.options.env.PORT);
                delete this.sites[domain];
                console.log(`Removed dead site: ${domain}`);
            }
        });
    }

    // Rate limit error logging to prevent spam
    shouldLogError(target, clientIP) {
        const key = `${clientIP}:${target}`;
        const now = Date.now();
        const logEntry = this.errorLogTracker.get(key);
        
        if (!logEntry) {
            this.errorLogTracker.set(key, { count: 1, firstSeen: now, lastLogged: now });
            return true;
        }
        
        logEntry.count++;
        
        // Reset counter if it's been more than 5 minutes since first error
        if (now - logEntry.firstSeen > 300000) {
            logEntry.count = 1;
            logEntry.firstSeen = now;
            logEntry.lastLogged = now;
            return true;
        }
        
        // Log first error, then every 10th error, but not more than once per minute
        if (logEntry.count === 1 || 
            (logEntry.count % 10 === 0 && now - logEntry.lastLogged > 60000)) {
            logEntry.lastLogged = now;
            return true;
        }
        
        return false;
    }
    static async attach(app,options) {
        const instance = new MultiSite(app,options);
        instance.config = new Config();

        // spawn declared sites
        if (fs.existsSync(resolve('./sites'))) {
            instance.sites = (fs.readdirSync(resolve('./sites'))).reduce((result,hostName)=>{
                const domainName = Site.WashName(hostName);
                const options = {
                    cwd: resolve(`./sites/${hostName}`),
                    env: {PORT:instance.spawnPort,meta:instance.options}
                };
                result[domainName] = Site.Spawn(domainName,options,instance);
                return result;
            },{});
        }
        app.use('/',instance.routes());
        return instance;
    }
    
    routes() {
        const router = express.Router();

        router.all(/.*/, async (req, res) => {
            const domain = Site.WashName(req.hostname);
            const site = this.sites[domain];
            if (site) {
                let target = `http://127.0.0.1:${site.options.env.PORT}${req.url}`;
                const method = req.method;
                const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(method);
                const payload = isBodyMethod ? req.body : null;
                const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];

                // Debug logging for POST requests
                if (method === 'POST') {
                    console.log(`[Proxy] ${method} ${target}`);
                    console.log(`[Proxy] Request body:`, req.body);
                    console.log(`[Proxy] Payload:`, payload);
                }

                const headersToForward = {
                    ...req.headers,
                    'content-length': undefined // Let Axios compute
                };


                try {
                    // Determine if this is a binary file request
                    const isBinaryRequest = /\.(woff2?|ttf|eot|otf|ico|png|jpe?g|gif|svg|pdf|zip|exe)(\?.*)?$/i.test(req.url);

                    if (isBinaryRequest) {
                        // Use streaming for binary files to avoid corruption
                        const response = await axios({
                            method,
                            url: target,
                            headers: headersToForward,
                            data: payload,
                            // Don't pass params - req.url already contains query string
                            validateStatus: () => true,
                            timeout: 30000,
                            responseType: 'stream'
                        });

                        console.log(`${response.status} ${target} (binary stream)`);

                        // Set headers without the problematic ones
                        const cleanHeaders = {...response.headers};
                        delete cleanHeaders['transfer-encoding'];
                        delete cleanHeaders['content-encoding'];

                        res.status(response.status).set(cleanHeaders);
                        response.data.pipe(res);
                    } else {
                        // Keep existing text/json handling
                        const response = await axios({
                            method,
                            url: target,
                            headers: headersToForward,
                            data: payload,
                            // Don't pass params - req.url already contains query string
                            validateStatus: () => true,
                            timeout: 30000,
                            responseType: 'text'
                        });

                        console.log(`${response.status} ${target}`);

                        const cleanHeaders = {...response.headers};
                        delete cleanHeaders['transfer-encoding'];
                        delete cleanHeaders['content-encoding'];

                        res.status(response.status).set(cleanHeaders).send(response.data);
                    }
                } catch (error) {
                    // Rate limit error logging to prevent spam
                    if (this.shouldLogError(target, clientIP)) {
                        const logEntry = this.errorLogTracker.get(`${clientIP}:${target}`);
                        if (logEntry && logEntry.count > 1) {
                            console.error(`${clientIP}:E: [Proxy] Error connecting to ${target}: ${error.message} (${logEntry.count} times)`);
                        } else {
                            console.error(`${clientIP}:E: [Proxy] Error connecting to ${target}: ${error.message}`);
                        }
                    }

                    // // Clean up dead processes
                    // this.removeDeadSites();
                    //
                    // // Try to respawn the site if it's down
                    // if (error.code === 'ECONNREFUSED') {
                    //     console.log(`[Proxy] Attempting to respawn site for ${domain}`);
                    //     this.sites[domain] = Site.Clone(domain, this);
                    //     return res.status(503).send('Service temporarily unavailable. Please try again in a few seconds.');
                    // }

                    res.status(502).send('Bad Gateway. Try reloading.');
                }
            } else {
                this.sites[domain] = Site.Clone(domain,this);
                // Retry the request after spawning
                setTimeout(() => {
                    res.redirect(`//${req.hostname}${req.url}`);
                }, 2000);
            }
        });
        return router;
    }
}
export class Site {
    constructor(name,options={},parent) {
        this.name = name;
        this.options = options;
        this.parent = parent;
        try {
            const envars = JSON.parse(process.env.SITE_ENV||{});
            Object.assign(this.options.env,envars[this.name]||{});
        } catch(e) {
            console.log(`Unable to parse SITE_ENV... continuing: ${e.message}`);
        }
    }
    static Spawn(name, options, parent) {
        const instance = new Site(name, options, parent);
        instance.spawn();
        return instance;
    }
    static Clone(name, multisite) {
        const options = {
            cwd: process.cwd(),
            env: {PORT:multisite.spawnPort,meta:multisite.options}
        };
        const instance = new Site(name,options);
        instance.spawn();
        return instance;
    }
    spawn() {
        let commands = (['run', 'start', this.name]);
        console.log(`Spawning site ${this.name} on port ${this.options.env.PORT}`);

        try {
            this.proc = child_process.spawn('npm', commands, this.options);

            this.proc.stdout.on('data', (data) => {
                process.stdout.write(`${this.name}: ${data.toString()}`);
            });

            this.proc.stderr.on('data', (data) => {
                process.stdout.write(`${this.name}:E: ${data.toString()}`);
            });

            this.proc.on('close', (code) => {
                console.log(`${this.name}: process exited with code ${code}`);
                this.proc = null;

                // Clear health check when process exits
                if (this.healthCheckIntervals) {
                    const intervalId = this.healthCheckIntervals.get(this.name);
                    if (intervalId) {
                        clearInterval(intervalId);
                        this.healthCheckIntervals.delete(this.name);
                    }
                }
            });

            this.proc.on('error', (err) => {
                console.error(`${this.name}: Failed to start process:`, err);
                this.proc = null;
            });

            // Give the process time to start, then begin health checks
            setTimeout(() => {
                if (this.proc && !this.proc.killed) {
                    console.log(`${this.name}: Successfully started on port ${this.options.env.PORT}`);

                    // Start health monitoring after a delay to allow process to fully start
                    if (this.startHealthCheck) {
                        setTimeout(() => {
                            if (this.proc && !this.proc.killed) {
                                this.startHealthCheck(this);
                            }
                        }, 5000); // Wait 5 seconds before starting health checks
                    }
                }
            }, 1000);

        } catch (err) {
            console.error(`${this.name}: Exception while spawning:`, err);
            this.proc = null;
        }
    }
    static WashName(hostName="") {
      if (!hostName || hostName.match(/^[\d]{1,3}\.[\d]{1,3}\.[\d]{1,3}\.[\d]{1,3}$/)) return "";
      else return hostName.toLowerCase();
    }
    static SafeName(hostName) {
      return Site.WashName(hostName).replace(/[^a-z0-9-]+/g,'_');
    }
}
