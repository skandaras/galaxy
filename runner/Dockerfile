# Runner image for coding sessions: each agent command executes in a fresh
# container from this image with that session's workspace, and nothing else
# from the data volume, mounted at the path it has in the app.
# Extend with whatever toolchains your repos need.
FROM node:22-alpine
RUN apk add --no-cache git bash coreutils python3 make g++ curl jq
RUN git config --system --add safe.directory '*'
