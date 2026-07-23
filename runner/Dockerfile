# Runner image for coding sessions: each agent command executes in a fresh
# container from this image with the shared data volume mounted at /data.
# Extend with whatever toolchains your repos need.
FROM node:22-alpine
RUN apk add --no-cache git bash coreutils python3 make g++ curl jq
RUN git config --system --add safe.directory '*'
