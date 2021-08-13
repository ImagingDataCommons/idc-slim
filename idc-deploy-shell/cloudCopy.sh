#!/usr/bin/env bash

# Copyright 2020, Institute for Systems Biology
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


cd ~/slim/build/
# Don't want to have to run whole script as sudo, so need to fix ownership here:
sudo chown -R circleci /home/circleci/.gsutil
sudo chgrp -R circleci /home/circleci/.gsutil

if [ "${CONFIG_ONLY}" != "True" ]; then
  gsutil web set -m index.html -e index.html gs://${WBUCKET}
  gsutil -h "Cache-Control:no-cache, max-age=0" rsync -d -r . gs://${WBUCKET}
else
  cd config
  gsutil cp proxy.js gs://${WBUCKET}/config
  CACHE_SETTING="Cache-Control:no-cache, max-age=0"
  gsutil setmeta -h "${CACHE_SETTING}" gs://${WBUCKET}/config/local.js
fi
