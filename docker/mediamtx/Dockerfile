FROM bluenviron/mediamtx:1 AS mediamtx

FROM ubuntu:24.04

COPY --from=mediamtx /mediamtx /
COPY ./docker/mediamtx/mediamtx.yml /mediamtx.yml

ENTRYPOINT ["/mediamtx"]
