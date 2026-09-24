#!/bin/sh

#backend
cp -r ./docker/backend/* ./backend/

#geoip-data
# FreeBank: no GeoLite2 download from GitHub - it is only used by the Lightning pages
# (MAXMIND_ENABLED=false). The empty folder keeps the backend Dockerfile's COPY working.
mkdir -p ./backend/GeoIP/

#frontend
localhostIP="127.0.0.1"
cp ./docker/frontend/* ./frontend
cp ./nginx.conf ./frontend/
cp ./nginx-mempool.conf ./frontend/
# FreeBank: the listen address comes from FRONTEND_HTTP_HOST (default 127.0.0.1, see entrypoint.sh),
# and the rate-limit exemption stays on 127.0.0.1 (upstream rewrote both to 0.0.0.0)
sed -i"" -e "s/${localhostIP}:80/__MEMPOOL_FRONTEND_HTTP_HOST__:__MEMPOOL_FRONTEND_HTTP_PORT__/g" ./frontend/nginx.conf
sed -i"" -e "s/user nobody;//g" ./frontend/nginx.conf
sed -i"" -e "s!/etc/nginx/nginx-mempool.conf!/etc/nginx/conf.d/nginx-mempool.conf!g" ./frontend/nginx.conf
sed -i"" -e "s/${localhostIP}:8999/__MEMPOOL_BACKEND_MAINNET_HTTP_HOST__:__MEMPOOL_BACKEND_MAINNET_HTTP_PORT__/g" ./frontend/nginx-mempool.conf
