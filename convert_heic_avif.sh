#!/bin/bash

files=$(find . -name '*.heic') 

for file in $files
do
  # auto-orient if the file has orientation data or is JPG format.
  # mogrify -auto-orient "$file"
  magick "$file" "${file%.heic}.avif"
  rm "$file"
done
