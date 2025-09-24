# administrate
Tools for site administration

## Certify
Certify will detect the hostname of incoming ssl requests and present the certs. If the domain name does not have a valid cert it requests one from letsencrypt and saves the keys to $HOME/.metric-im/

```javascript
import https from "https";
import { Certify } from '@metric-im/administrate';
const app = express();
const certify = await Certify.attach(app,{contactEmail:'me@there.com'});
// certify.SNI return {key: xxx, cert: ...} for the current domain and/or triggers a request for a cert
const https_server = https.createServer({...certify.SNI},app);
```

## Multisite
Multisite acts as a proxy service. It listens on port 80 (4080), 443 (4443) for all web traffic and routes to the designated service. A service is identified by domain name. multisite will look for a service matching the incoming domain name in the *sites* folder. It spawns the app found with npm start and assigns it an http port. All subsquent traffic for that domain are routed to this process. Multisite can also clone itelf so that there is unique process running for each domain being interacted.

```javascript
const multiSite = MultiSite.attach(app);
```
See the Roots project [Harness](https;//github.com/rootz-global/harness). This is a simple host for multisite. It expects symlinks to all the apps the server responds to by domain name.

## Syncrhonize
Provides a web hook to github for manaing synchronization with a code branch.
