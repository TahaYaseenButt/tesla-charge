#!/bin/bash


if [ -z "$DATABASE_URL" ]; then
    echo "DATABASE_URL is not set."
else
    echo "DATABASE_URL=$DATABASE_URL" > ./.env
    echo ".env file updated with DATABASE_URL"
fi


exec "$@"