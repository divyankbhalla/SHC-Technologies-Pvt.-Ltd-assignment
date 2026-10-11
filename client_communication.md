**To:** [IT Director], GlobalHealth Corp
**From:** [Your Name], Forward Deployed Engineer, SHC Technologies
**Subject:** Patient data migration: running the ingestion container in your environment

Hi [Name],

We've completed the ingestion tool for migrating your legacy patient records into the SHC Platform. It ships as a Docker container that runs entirely inside your infrastructure, so your CSV export and the cleaning step never leave your network. Only the cleaned records are sent to the SHC API.

**Building and running the container**

1. Unpack the delivered package (`shc-ingestion.zip`) and open a terminal in the project folder, the one containing the `Dockerfile`, `package.json` and `package-lock.json`. Then build the image (requires Docker 20+; the build is multi-stage and the final image runs as a non-root user):

   ```
   docker build -t shc-ingest .
   ```

   The build downloads dependencies from the public npm registry. If your build servers have no internet access, build on a connected machine and transfer the image instead:

   ```
   docker save shc-ingest | gzip > shc-ingest.tar.gz      # on the connected machine
   docker load < shc-ingest.tar.gz                        # on your server
   ```

2. Run it, mounting the CSV export read-only and a folder for output:

   ```
   docker run --rm \
     -e SHC_API_TOKEN="<your SHC API token>" \
     -v /path/to/patients.csv:/data/patients.csv:ro \
     -v /path/to/output:/output \
     shc-ingest
   ```

   The output folder must exist and be writable before you run the command. The token is passed at runtime and is never stored in the image. If you use Docker or Kubernetes secrets, set `SHC_API_TOKEN_FILE` to the mounted secret path instead. Optional settings (`BATCH_SIZE`, `MAX_RETRIES`, and so on) are documented in the README. Adding `-e DRY_RUN=true` validates and cleans the file without sending anything, which we recommend for a first pass.

   When the run finishes, the container exits with code `0` if every record was loaded, `2` if the run completed but some records need review (see below), and `1` if it had to stop (for example, an invalid API token).

**What the tool found in the export, and how it handled it**

- **Missing emails and phone numbers:** these are sent as empty values rather than being rejected or invented. Malformed values (e.g. an email with no domain) are treated the same way and counted separately.
- **Inconsistent date formats:** dates of birth appeared in several formats and are all converted to `YYYY-MM-DD`. Anything that isn't a real calendar date is left blank and flagged rather than guessed.
- **Duplicate patient IDs:** where an ID appears more than once, we keep the record with the most recent `last_modified` timestamp and discard the older versions.
- **Currency formatting:** balances containing symbols, commas or accounting-style negatives are converted to plain numbers.
- **Rows with no patient ID:** these cannot be loaded safely and are written to a failed-records file for your team to review.

Each run prints a summary of these counts (counts only, no patient data in the logs). Any record the SHC API rejects is written to `failed_records.json` in the output folder, and the run continues with the remaining records. Please note that this file contains patient information, so it should be stored on a volume with the same access controls as the source data. The tool respects the API's limits (100 records per request, 5 requests per second) and automatically retries temporary errors.

**One recommendation for your legacy export**

Please have the export write all dates in ISO 8601 format (`YYYY-MM-DD`, and `YYYY-MM-DDTHH:MM:SSZ` for timestamps). Dates such as `04/05/1980` are genuinely ambiguous between April 5 and May 4, and our tool can only resolve those by convention. A misread date of birth in a patient record is a clinical-safety risk, and a single standard format at the source removes that risk entirely and makes every future load cleaner.

I'm happy to walk your team through the first run or join a call to review the summary output together.

Best regards,
[Your Name]
Forward Deployed Engineer, SHC Technologies
[email / phone]