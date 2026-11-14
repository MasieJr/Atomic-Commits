# Azure VM deployment

The current demonstration runs at `https://varsity-connect-vc-2026.spaincentral.cloudapp.azure.com/` on the Azure `vc-vm` VM. Nginx serves `/var/www/atomic-commits` and proxies `/api/` and `/health` to `atomic-commits.service` on `127.0.0.1:3100`.

The Node 22 runtime is in `/opt/atomic-commits/runtime`; application files are in `/opt/atomic-commits/app`. The service runs as `atomic-commits`. Its environment and provider signing key are under `/etc/atomic-commits` with restricted permissions. Never copy their contents into logs, chat or Git.

```sh
sudo systemctl status atomic-commits nginx --no-pager
sudo journalctl -u atomic-commits -n 50 --no-pager
curl -fsS https://varsity-connect-vc-2026.spaincentral.cloudapp.azure.com/health
```

The existing version-1 encryption key was not available for this deployment. The server uses a separately generated version-2 key. To read old version-1 provider and device records, add the original key as `DATA_ENCRYPTION_KEY_V1` in the protected service environment and restart the service. Until then, users must approve new grants and enroll new devices.

## Restore the previous site

The original Nginx configuration is saved at `/etc/nginx/sites-available/varsity-connect.pre-atomic-20261113`. The two previous service definitions, MySQL database and uploads remain on the VM. To restore the previous site:

```sh
sudo systemctl enable --now varsity-connect.service
sudo systemctl start varsity-connect-housing-preview.service
sudo cp -p /etc/nginx/sites-available/varsity-connect.pre-atomic-20261113 /etc/nginx/sites-enabled/varsity-connect
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl disable --now atomic-commits.service
```

The old public AWS backend at `13.246.236.101:3000` is separate from this Azure VM and was not stopped by this deployment.
