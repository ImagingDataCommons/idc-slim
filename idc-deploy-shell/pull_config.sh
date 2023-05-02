#!/usr/bin/env bash

LOCATION=`echo ${CIRCLE_WORKING_DIRECTORY} | sed -e 's#~/##'`

if [ ! -f "/home/circleci/${LOCATION}/slim_viewer_deployment_config.txt" ]; then
    gsutil cp gs://${DEPLOYMENT_BUCKET}/slim_viewer_deployment_config.txt /home/circleci/${LOCATION}/
    chmod ugo+r /home/circleci/${LOCATION}/slim_viewer_deployment_config.txt
    if [ ! -f "/home/circleci/${LOCATION}/slim_viewer_deployment_config.txt" ]; then
      echo "[ERROR] Couldn't assign viewer deployment configuration file - exiting."
      exit 1
    fi
else
    echo "Found deployment configuration file."
fi
